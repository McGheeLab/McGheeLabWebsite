/* ================================================================
   Settings App — McGheeLab
   ================================================================
   Unified settings for all lab apps:
   - Profile editing (all users)
   - Notification preferences + quiet hours (all users)
   - Per-app admin settings (meeting admins, chat admins)
   - Site admin links (global admins)
   ================================================================ */

(() => {
  const appEl = document.getElementById('app');
  let _user = null;
  let _profile = null;
  let _userSettings = null;
  let _appAdminMap = {};  // { meetings: true, chat: false, ... }
  const db = () => McgheeLab.db;

  /* ─── Bootstrap ──────────────────────────────────────────── */

  McgheeLab.AppBridge.onReady(async (user, profile) => {
    _user = user;
    _profile = profile;
    await loadData();
    render();
    wire();
  });

  /* ─── Data Loading ───────────────────────────────────────── */

  async function loadData() {
    // Load user settings
    try {
      const doc = await db().collection('userSettings').doc(_user.uid).get();
      _userSettings = doc.exists ? doc.data() : getDefaultSettings();
    } catch {
      _userSettings = getDefaultSettings();
    }

    // Detect per-app admin status
    _appAdminMap = {};
    const isGlobalAdmin = _profile?.role === 'admin';

    if (isGlobalAdmin) {
      _appAdminMap = { meetings: true, chat: true, equipment: true, huddle: true, scheduler: true, activityTracker: true };
    } else {
      // Check meeting admin
      try {
        const mtgDoc = await db().collection('meetingConfig').doc('settings').get();
        if (mtgDoc.exists) {
          const admins = mtgDoc.data()?.meetingAdmins || [];
          if (admins.includes(_user.uid)) _appAdminMap.meetings = true;
        }
      } catch { /* no access */ }

      // Check chat admin
      try {
        const chatDoc = await db().collection('chatConfig').doc('settings').get();
        if (chatDoc.exists) {
          const admins = chatDoc.data()?.chatAdmins || [];
          if (admins.includes(_user.uid)) _appAdminMap.chat = true;
        }
      } catch { /* no access */ }
    }
  }

  function getDefaultSettings() {
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
          activityTracker: { push: false }
        }
      }
    };
  }

  /* ─── Render ─────────────────────────────────────────────── */

  function render() {
    const notif = _userSettings?.notifications || getDefaultSettings().notifications;
    const qh = notif.quietHours || { enabled: false, start: '22:00', end: '07:00' };
    const apps = notif.apps || {};
    const isAdmin = _profile?.role === 'admin';
    const hasAnyAdmin = Object.values(_appAdminMap).some(Boolean);
    const initial = (_profile?.name || _user?.email || '?')[0].toUpperCase();

    appEl.innerHTML = `
      <div class="settings-page">

        <!-- Profile -->
        <div class="settings-section">
          <h2>Profile</h2>
          <div class="settings-profile-row">
            ${_profile?.photoURL
              ? `<img src="${esc(_profile.photoURL)}" class="settings-avatar" alt="Profile photo" />`
              : `<div class="settings-avatar-placeholder">${initial}</div>`}
            <div class="settings-profile-info">
              <div class="settings-profile-name">${esc(_profile?.name || _user?.email || '')}</div>
              <div class="settings-profile-category">${esc(formatCategory(_profile?.category))}</div>
            </div>
          </div>
          <div class="settings-field">
            <label for="settings-name">Display Name</label>
            <input type="text" id="settings-name" value="${esc(_profile?.name || '')}" />
          </div>
          <div class="settings-field">
            <label for="settings-bio">Bio</label>
            <textarea id="settings-bio">${esc(_profile?.bio || '')}</textarea>
          </div>
          <button class="settings-save-btn" id="save-profile-btn">Save Profile</button>
          <div id="profile-status"></div>
        </div>

        <!-- Notifications -->
        <div class="settings-section">
          <h2>Notifications</h2>

          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-label">Push Notifications</div>
              <div class="settings-toggle-sub">Master toggle for all notifications</div>
            </div>
            ${toggleHTML('notif-master', notif.enabled)}
          </div>

          <h3>Per-App Notifications</h3>
          ${notifToggleRow('notif-chat', 'Lab Chat', 'Messages, mentions, DMs', apps.chat?.push)}
          ${notifToggleRow('notif-meetings', 'Lab Meetings', 'Meeting reminders and agenda updates', apps.meetings?.push)}
          ${notifToggleRow('notif-equipment', 'Equipment', 'Booking confirmations and reminders', apps.equipment?.push)}
          ${notifToggleRow('notif-huddle', 'The Huddle', 'Weekly plan updates', apps.huddle?.push)}
          ${notifToggleRow('notif-scheduler', 'Scheduler', 'Schedule invitations and changes', apps.scheduler?.push)}
          ${notifToggleRow('notif-activity', 'Activity Tracker', 'Daily reminders', apps.activityTracker?.push)}

          <h3>Quiet Hours</h3>
          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-label">Do Not Disturb</div>
              <div class="settings-toggle-sub">Silence notifications during set hours</div>
            </div>
            ${toggleHTML('notif-quiet', qh.enabled)}
          </div>
          <div class="settings-time-row" id="quiet-hours-times" style="${qh.enabled ? '' : 'opacity:.4;pointer-events:none'}">
            <label for="quiet-start">From</label>
            <input type="time" id="quiet-start" value="${qh.start || '22:00'}" />
            <label for="quiet-end">To</label>
            <input type="time" id="quiet-end" value="${qh.end || '07:00'}" />
          </div>

          <button class="settings-save-btn" id="save-notif-btn" style="margin-top:1rem">Save Notification Settings</button>
          <div id="notif-status"></div>
        </div>

        <!-- Per-App Administration -->
        ${hasAnyAdmin ? `
          <div class="settings-section">
            <h2>App Administration</h2>
            ${_appAdminMap.meetings ? adminCard('Meetings', 'Manage meeting defaults, semester config, and meeting admins', 'meetings') : ''}
            ${_appAdminMap.chat ? adminCard('Lab Chat', 'Manage channel categories, chat admins, and user roles', 'chat') : ''}
            ${_appAdminMap.equipment ? adminCard('Equipment', 'Manage devices, training certifications, and calendar sync', 'equipment') : ''}
          </div>
        ` : ''}

        <!-- Site Administration (global admin only) -->
        ${isAdmin ? `
          <div class="settings-section">
            <h2>Site Administration</h2>
            <div class="settings-admin-card">
              <div class="settings-admin-card-info">
                <div class="settings-admin-card-title">Users & Invitations</div>
                <div class="settings-admin-card-desc">Manage lab members, roles, and invitations</div>
              </div>
              <a href="../../#/admin" target="_top" class="settings-admin-link">Open &rarr;</a>
            </div>
            <div class="settings-admin-card">
              <div class="settings-admin-card-info">
                <div class="settings-admin-card-title">Content Review</div>
                <div class="settings-admin-card-desc">Approve pending stories, news, and opportunities</div>
              </div>
              <a href="../../#/admin" target="_top" class="settings-admin-link">Open &rarr;</a>
            </div>
          </div>
        ` : ''}

        <!-- Logout -->
        <div class="settings-section">
          <button class="settings-logout-btn" id="settings-logout">Sign Out</button>
        </div>

      </div>
    `;
  }

  /* ─── Wire ───────────────────────────────────────────────── */

  function wire() {
    // Save profile
    document.getElementById('save-profile-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('save-profile-btn');
      const name = document.getElementById('settings-name')?.value?.trim();
      const bio = document.getElementById('settings-bio')?.value?.trim();
      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        await db().collection('users').doc(_user.uid).update({ name, bio });
        _profile.name = name;
        _profile.bio = bio;
        showStatus('profile-status', 'Profile saved', 'success');
      } catch (err) {
        showStatus('profile-status', 'Failed to save: ' + err.message, 'error');
      }
      btn.disabled = false;
      btn.textContent = 'Save Profile';
    });

    // Save notification settings
    document.getElementById('save-notif-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('save-notif-btn');
      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        const settings = {
          notifications: {
            enabled: isChecked('notif-master'),
            quietHours: {
              enabled: isChecked('notif-quiet'),
              start: document.getElementById('quiet-start')?.value || '22:00',
              end: document.getElementById('quiet-end')?.value || '07:00'
            },
            apps: {
              chat:            { push: isChecked('notif-chat') },
              meetings:        { push: isChecked('notif-meetings') },
              equipment:       { push: isChecked('notif-equipment') },
              huddle:          { push: isChecked('notif-huddle') },
              scheduler:       { push: isChecked('notif-scheduler') },
              activityTracker: { push: isChecked('notif-activity') }
            }
          }
        };
        await db().collection('userSettings').doc(_user.uid).set(settings, { merge: true });
        _userSettings = settings;

        // Sync quiet hours to IndexedDB for the service worker
        syncQuietHoursToIDB(settings.notifications.quietHours);

        showStatus('notif-status', 'Notification settings saved', 'success');
      } catch (err) {
        showStatus('notif-status', 'Failed to save: ' + err.message, 'error');
      }
      btn.disabled = false;
      btn.textContent = 'Save Notification Settings';
    });

    // Quiet hours toggle → enable/disable time inputs
    document.getElementById('notif-quiet')?.addEventListener('change', (e) => {
      const times = document.getElementById('quiet-hours-times');
      if (times) {
        times.style.opacity = e.target.checked ? '' : '.4';
        times.style.pointerEvents = e.target.checked ? '' : 'none';
      }
    });

    // Admin card links — navigate parent to app
    document.querySelectorAll('.settings-admin-link[data-app]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const appId = link.dataset.app;
        if (McgheeLab.AppBridge.isEmbedded()) {
          window.parent.location.hash = `#/apps/${appId}`;
        } else {
          window.location.href = `../../#/apps/${appId}`;
        }
      });
    });

    // Logout
    document.getElementById('settings-logout')?.addEventListener('click', () => {
      if (McgheeLab.auth) {
        McgheeLab.auth.signOut().then(() => {
          if (McgheeLab.AppBridge.isEmbedded()) {
            window.parent.location.hash = '#/login';
          } else {
            window.location.href = '../../#/login';
          }
        });
      }
    });
  }

  /* ─── Helpers ────────────────────────────────────────────── */

  function toggleHTML(id, checked) {
    return `<label class="settings-toggle">
      <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} />
      <span class="slider"></span>
    </label>`;
  }

  function notifToggleRow(id, label, sub, checked) {
    return `<div class="settings-toggle-row">
      <div>
        <div class="settings-toggle-label">${label}</div>
        <div class="settings-toggle-sub">${sub}</div>
      </div>
      ${toggleHTML(id, checked !== false)}
    </div>`;
  }

  function adminCard(title, desc, appId) {
    return `<div class="settings-admin-card">
      <div class="settings-admin-card-info">
        <div class="settings-admin-card-title">${title}</div>
        <div class="settings-admin-card-desc">${desc}</div>
      </div>
      <a href="#" class="settings-admin-link" data-app="${appId}">Manage &rarr;</a>
    </div>`;
  }

  function isChecked(id) {
    return document.getElementById(id)?.checked || false;
  }

  function showStatus(elId, msg, type) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.className = `settings-status settings-status--${type}`;
    el.textContent = msg;
    setTimeout(() => { el.textContent = ''; el.className = ''; }, 4000);
  }

  function formatCategory(cat) {
    const map = { pi: 'Principal Investigator', postdoc: 'Postdoc', grad: 'Graduate Student', undergrad: 'Undergraduate', highschool: 'High School', alumni: 'Alumni', guest: 'Guest', visiting: 'Visiting Researcher' };
    return map[cat] || cat || 'Member';
  }

  function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* ─── IndexedDB sync for quiet hours (service worker access) ─── */

  function syncQuietHoursToIDB(quietHours) {
    try {
      const req = indexedDB.open('mcgheelab-prefs', 1);
      req.onupgradeneeded = (e) => e.target.result.createObjectStore('settings');
      req.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('settings', 'readwrite');
        tx.objectStore('settings').put(quietHours, 'quietHours');
      };
    } catch { /* best-effort */ }
  }
})();
