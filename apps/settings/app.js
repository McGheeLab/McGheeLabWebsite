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

  McgheeLab.AppBridge.init();

  McgheeLab.AppBridge.onReady(async (user, profile) => {
    _user = user;
    _profile = profile;
    await loadData();
    // Init shared calendar service
    if (McgheeLab.CalendarService) {
      await McgheeLab.CalendarService.init(_user, { toast: (msg) => showStatus('cal-status', msg, 'success') });
    }
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

          <h3>This Device</h3>
          <div id="device-push-status" class="device-push-status">
            <div class="device-push-checking">Checking device registration...</div>
          </div>
        </div>

        <!-- Calendar Integration -->
        <div class="settings-section">
          <h2>Calendar Integration</h2>
          <p style="color:var(--muted);font-size:.82rem;margin-bottom:1rem">Connected calendars sync across Activity Tracker and The Huddle.</p>
          ${renderCalendarSection()}
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

          <div class="settings-section">
            <h2>Test Notifications</h2>

            <div id="push-diagnostics" style="background:var(--bg);border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:.75rem 1rem;margin-bottom:1rem;font-size:.82rem">
              <div style="font-weight:600;margin-bottom:.5rem;color:var(--text)">Push Diagnostics</div>
              <div id="push-diag-info" style="color:var(--muted);line-height:1.6">Checking...</div>
              <button class="settings-save-btn" id="push-reregister" style="margin-top:.75rem;background:#f59e0b;font-size:.82rem">Re-register for Push Notifications</button>
              <div id="push-diag-status" style="margin-top:.5rem"></div>
            </div>

            <p style="color:var(--muted);font-size:.82rem;margin-bottom:1rem">Send a test push notification to your devices. Bypasses notification settings so the notification always arrives.</p>
            <div class="test-notif-grid">
              <h3>Chat</h3>
              ${testNotifBtn('chat', 'Channel Message')}
              ${testNotifBtn('chat-dm', 'Direct Message')}
              ${testNotifBtn('chat-mention', '@Mention')}
              <h3>Huddle</h3>
              ${testNotifBtn('huddle-join', 'Someone Joined')}
              ${testNotifBtn('huddle-status', 'Status Changed')}
              ${testNotifBtn('help-request', 'Help Request')}
              ${testNotifBtn('help-response', 'Help Response')}
              <h3>Equipment</h3>
              ${testNotifBtn('equipment-approval', 'Booking Request')}
              ${testNotifBtn('equipment-confirmed', 'Booking Confirmed')}
              ${testNotifBtn('equipment-displaced', 'Booking Displaced')}
            </div>
            <button class="settings-save-btn" id="test-notif-all" style="margin-top:1rem;background:#6366f1">Send All (one per second)</button>
            <div id="test-notif-status"></div>
          </div>
        ` : ''}

        <!-- App Version -->
        <div class="settings-section">
          <h2>App Version</h2>
          <div id="current-version" style="color:var(--muted);font-size:.82rem;margin-bottom:1rem">Detecting version...</div>
          <div id="update-status" style="margin-bottom:.75rem"></div>
          <button class="settings-save-btn" id="check-update-btn">Check for Updates</button>
        </div>

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

    // Calendar integration
    wireCalendar();

    // Check for updates
    wireUpdateButton();

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

    // Device push status (all users)
    wireDevicePushStatus();

    // Admin-only: test notifications + diagnostics
    if (_profile?.role === 'admin') {
      wireTestNotifications();
      wirePushDiagnostics();
    }
  }

  /* ─── App Update ─────────────────────────────────────────── */

  function wireUpdateButton() {
    const btn = document.getElementById('check-update-btn');
    const status = document.getElementById('update-status');
    const versionEl = document.getElementById('current-version');
    if (!btn || !status) return;

    // Access the parent page's SW registration (works embedded or standalone)
    function getSwReg() {
      // Embedded: parent page stores it on window.__swReg
      if (McgheeLab.AppBridge.isEmbedded()) {
        try { return window.parent.__swReg; } catch { return null; }
      }
      // Standalone: use own navigator
      return window.__swReg || null;
    }

    // Detect current cache version by reading sw.js source
    if (versionEl) {
      (async () => {
        try {
          const resp = await fetch('/sw.js', { cache: 'no-store' });
          const text = await resp.text();
          const match = text.match(/CACHE_VERSION\s*=\s*(\d+)/);
          if (match) {
            versionEl.textContent = `Current version: ${match[1]}`;
          } else {
            versionEl.textContent = '';
          }
        } catch {
          versionEl.textContent = '';
        }
      })();
    }

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Checking...';
      status.innerHTML = '';

      try {
        // Get or fetch the SW registration
        let reg = getSwReg();
        if (!reg && 'serviceWorker' in navigator) {
          reg = await navigator.serviceWorker.getRegistration();
        }
        // Also try parent's navigator for embedded mode
        if (!reg && McgheeLab.AppBridge.isEmbedded()) {
          try { reg = await window.parent.navigator.serviceWorker.getRegistration(); } catch {}
        }

        if (!reg) {
          status.innerHTML = '<span style="color:var(--warning)">No service worker found. Try reloading the app.</span>';
          btn.disabled = false;
          btn.textContent = 'Check for Updates';
          return;
        }

        // Force the browser to check for a new sw.js
        await reg.update();

        // Check if a new worker is waiting or installing
        if (reg.waiting) {
          // There's a new version ready — tell it to activate immediately
          status.innerHTML = '<span style="color:var(--accent)">New version found! Installing...</span>';
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          // The controllerchange listener in index.html will auto-reload
        } else if (reg.installing) {
          status.innerHTML = '<span style="color:var(--accent)">Update downloading...</span>';
          reg.installing.addEventListener('statechange', function() {
            if (this.state === 'installed') {
              status.innerHTML = '<span style="color:var(--accent)">New version ready! Reloading...</span>';
              if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        } else {
          status.innerHTML = '<span style="color:var(--success)">You\'re on the latest version.</span>';
        }
      } catch (err) {
        status.innerHTML = `<span style="color:var(--danger)">Update check failed: ${esc(err.message)}</span>`;
      }

      btn.disabled = false;
      btn.textContent = 'Check for Updates';
    });
  }

  /* ─── Device Push Status (all users) ─────────────────────── */

  async function wireDevicePushStatus() {
    const container = document.getElementById('device-push-status');
    if (!container) return;

    const hasNotifAPI = 'Notification' in window;
    const hasSW = 'serviceWorker' in navigator;
    const hasPush = !!window.McgheePush;
    const permission = hasNotifAPI ? Notification.permission : 'unsupported';

    // Check if this device has a token in Firestore
    let tokenCount = 0;
    try {
      const snap = await db().collection('users').doc(_user.uid).collection('pushTokens').get();
      tokenCount = snap.size;
    } catch { /* ignore */ }

    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

    // Determine state
    let state; // 'registered', 'needs-register', 'denied', 'unsupported'
    if (!hasNotifAPI || !hasSW) {
      state = 'unsupported';
    } else if (permission === 'denied') {
      state = 'denied';
    } else if (permission === 'granted' && tokenCount > 0) {
      state = 'registered';
    } else {
      state = 'needs-register';
    }

    const checkIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" style="vertical-align:-3px"><polyline points="20 6 9 17 4 12"/></svg>';
    const warnIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.5" style="vertical-align:-3px"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    const xIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" style="vertical-align:-3px"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';

    if (state === 'registered') {
      container.innerHTML = `
        <div class="device-push-ok">
          ${checkIcon} <strong>This device is registered for notifications</strong>
          <div style="color:var(--muted);font-size:.78rem;margin-top:.25rem">${tokenCount} device${tokenCount !== 1 ? 's' : ''} registered to your account</div>
        </div>`;
    } else if (state === 'needs-register') {
      container.innerHTML = `
        <div class="device-push-warn">
          ${warnIcon} <strong>This device is not registered for notifications</strong>
          ${!isStandalone && isIOS ? '<div style="color:var(--muted);font-size:.78rem;margin-top:.25rem">On iOS, install the app to your home screen first, then open it from there.</div>' : ''}
          <button class="settings-save-btn" id="device-push-register" style="margin-top:.75rem;font-size:.85rem">Enable Push Notifications</button>
          <div id="device-push-msg" style="margin-top:.5rem"></div>
        </div>`;
      document.getElementById('device-push-register')?.addEventListener('click', async () => {
        const btn = document.getElementById('device-push-register');
        btn.disabled = true;
        btn.textContent = 'Registering...';
        try {
          if (hasPush) {
            McgheePush.init();
            const token = await McgheePush.requestPermission(_user.uid);
            if (token) {
              showStatus('device-push-msg', 'Device registered successfully!', 'success');
              // Refresh the status display
              await wireDevicePushStatus();
            } else {
              const p = Notification.permission;
              if (p === 'denied') {
                showStatus('device-push-msg', isIOS
                  ? 'Permission denied. Go to iOS Settings > McGheeLab > Notifications > Allow.'
                  : 'Permission denied. Reset in your browser site settings.', 'error');
              } else {
                showStatus('device-push-msg', 'Could not get a push token. Try reloading the app.', 'error');
              }
              btn.disabled = false;
              btn.textContent = 'Enable Push Notifications';
            }
          } else {
            showStatus('device-push-msg', 'Push module not loaded. Try reloading the app.', 'error');
            btn.disabled = false;
            btn.textContent = 'Enable Push Notifications';
          }
        } catch (err) {
          showStatus('device-push-msg', 'Error: ' + err.message, 'error');
          btn.disabled = false;
          btn.textContent = 'Enable Push Notifications';
        }
      });
    } else if (state === 'denied') {
      container.innerHTML = `
        <div class="device-push-denied">
          ${xIcon} <strong>Notifications are blocked for this app</strong>
          <div style="color:var(--muted);font-size:.78rem;margin-top:.25rem">${isIOS
            ? 'Go to <strong>iOS Settings > McGheeLab > Notifications</strong> and turn on Allow Notifications, then come back here.'
            : 'Reset notification permissions in your browser\'s site settings, then reload this page.'}</div>
        </div>`;
    } else {
      container.innerHTML = `
        <div class="device-push-unsupported">
          ${xIcon} <strong>Push notifications are not supported on this browser</strong>
          <div style="color:var(--muted);font-size:.78rem;margin-top:.25rem">Try using Chrome, Edge, or Safari 16.4+ with the app installed to your home screen.</div>
        </div>`;
    }
  }

  /* ─── Test Notifications ─────────────────────────────────── */

  function wireTestNotifications() {
    const sendTest = async (type, btn) => {
      const origText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Sending...';
      try {
        const callable = McgheeLab.firebase.functions().httpsCallable('sendTestNotification');
        const result = await callable({ type });
        const data = result.data;
        if (data.success) {
          btn.textContent = 'Sent!';
          btn.style.background = '#22c55e';
          showStatus('test-notif-status', `"${type}" sent to ${data.sent} device(s). ${data.staleTokensCleaned ? data.staleTokensCleaned + ' stale token(s) cleaned.' : ''}`, 'success');
        } else {
          btn.textContent = 'Failed';
          btn.style.background = '#ef4444';
          showStatus('test-notif-status', data.error || 'Send failed', 'error');
        }
      } catch (err) {
        btn.textContent = 'Error';
        btn.style.background = '#ef4444';
        showStatus('test-notif-status', err.message, 'error');
      }
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = origText;
        btn.style.background = '';
      }, 2000);
    };

    document.querySelectorAll('.test-notif-btn').forEach(btn => {
      btn.addEventListener('click', () => sendTest(btn.dataset.type, btn));
    });

    // Send all button
    document.getElementById('test-notif-all')?.addEventListener('click', async () => {
      const allBtn = document.getElementById('test-notif-all');
      allBtn.disabled = true;
      allBtn.textContent = 'Sending...';
      const buttons = [...document.querySelectorAll('.test-notif-btn')];
      for (let i = 0; i < buttons.length; i++) {
        buttons[i].click();
        if (i < buttons.length - 1) await new Promise(r => setTimeout(r, 1500));
      }
      allBtn.disabled = false;
      allBtn.textContent = 'Send All (one per second)';
    });
  }

  /* ─── Push Diagnostics ───────────────────────────────────── */

  async function wirePushDiagnostics() {
    const infoEl = document.getElementById('push-diag-info');
    if (!infoEl) return;

    const lines = [];

    // 1. Browser support
    const hasNotifAPI = 'Notification' in window;
    const hasSW = 'serviceWorker' in navigator;
    lines.push(`Notification API: ${hasNotifAPI ? 'Yes' : 'No'}`);
    lines.push(`Service Worker API: ${hasSW ? 'Yes' : 'No'}`);

    // 2. Permission state
    const perm = hasNotifAPI ? Notification.permission : 'unsupported';
    const permColor = perm === 'granted' ? '#22c55e' : perm === 'denied' ? '#ef4444' : '#f59e0b';
    lines.push(`Permission: <span style="color:${permColor};font-weight:600">${perm}</span>`);

    // 3. Standalone mode
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    lines.push(`Standalone (PWA): ${isStandalone ? 'Yes' : 'No'}`);

    // 4. Platform
    const ua = navigator.userAgent;
    const isIOS = /iPhone|iPad|iPod/.test(ua);
    const platform = isIOS ? 'iOS' : /Android/.test(ua) ? 'Android' : 'Desktop';
    lines.push(`Platform: ${platform}`);

    if (isIOS) {
      lines.push(`<span style="color:var(--muted)">iOS requires: 16.4+, Safari, Add to Home Screen, standalone mode</span>`);
    }

    // 5. Service worker registrations
    if (hasSW) {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        lines.push(`Service workers registered: ${regs.length}`);
        regs.forEach((reg, i) => {
          lines.push(`&nbsp;&nbsp;SW${i + 1}: ${reg.active ? 'active' : reg.installing ? 'installing' : 'waiting'} — scope: ${reg.scope}`);
        });
      } catch (err) {
        lines.push(`Service worker check error: ${err.message}`);
      }
    }

    // 6. McgheePush state
    const hasPush = !!window.McgheePush;
    lines.push(`McgheePush module: ${hasPush ? 'Loaded' : '<span style="color:#ef4444">Not loaded</span>'}`);
    if (hasPush) {
      lines.push(`McgheePush.isSupported(): ${McgheePush.isSupported()}`);
    }

    // 7. Token count in Firestore
    try {
      const snap = await db().collection('users').doc(_user.uid).collection('pushTokens').get();
      const count = snap.size;
      const countColor = count > 0 ? '#22c55e' : '#ef4444';
      lines.push(`Tokens in Firestore: <span style="color:${countColor};font-weight:600">${count}</span>`);
      if (count > 0) {
        snap.forEach(doc => {
          const d = doc.data();
          lines.push(`&nbsp;&nbsp;${d.platform || '?'} — ${(d.token || doc.id).substring(0, 20)}...`);
        });
      }
    } catch (err) {
      lines.push(`Token lookup error: ${err.message}`);
    }

    infoEl.innerHTML = lines.join('<br>');

    // Re-register button
    document.getElementById('push-reregister')?.addEventListener('click', async () => {
      const btn = document.getElementById('push-reregister');
      btn.disabled = true;
      btn.textContent = 'Registering...';

      try {
        // Ensure McgheePush is initialized
        if (window.McgheePush) {
          McgheePush.init();

          // Request permission + get token
          const token = await McgheePush.requestPermission(_user.uid);
          if (token) {
            showStatus('push-diag-status', `Token registered: ${token.substring(0, 20)}...`, 'success');
          } else {
            // Try to get more info about why it failed
            const p = Notification.permission;
            if (p === 'denied') {
              showStatus('push-diag-status', 'Permission denied by browser/OS. On iOS: Settings > McGheeLab > Notifications > Allow.', 'error');
            } else if (p === 'default') {
              showStatus('push-diag-status', 'Permission not yet granted. Try tapping again — the browser should show a prompt.', 'error');
            } else {
              showStatus('push-diag-status', 'Token generation failed. Check that the service worker is registered.', 'error');
            }
          }
        } else {
          showStatus('push-diag-status', 'McgheePush module not loaded. Try reloading the app.', 'error');
        }
      } catch (err) {
        showStatus('push-diag-status', 'Error: ' + err.message, 'error');
      }

      btn.disabled = false;
      btn.textContent = 'Re-register for Push Notifications';

      // Refresh diagnostics
      await wirePushDiagnostics();
    });
  }

  /* ─── Calendar Integration ────────────────────────────────── */

  function renderCalendarSection() {
    const cal = McgheeLab.CalendarService;
    if (!cal) return '<p style="color:var(--muted);font-size:.82rem">Calendar service not loaded.</p>';

    const cfg = cal.getConfig();
    const conn = cal.isConnected();

    let html = '<div class="settings-cal-providers">';

    // Google Calendar
    html += `<div class="settings-cal-card">
      <div class="settings-cal-header">
        <span class="settings-cal-icon">${googleIcon()}</span>
        <strong>Google Calendar</strong>
        <span class="settings-cal-badge ${conn.google ? 'settings-cal-badge--on' : ''}">${conn.google ? 'Connected' : 'Not connected'}</span>
      </div>
      ${conn.google
        ? `<button class="settings-save-btn" id="cal-gcal-disconnect" style="margin-top:.5rem;background:#f44336">Disconnect</button>`
        : `<div style="margin-top:.5rem">
            <div class="settings-field">
              <label>OAuth Client ID</label>
              <input type="text" id="cal-gcal-client-id" placeholder="xxxx.apps.googleusercontent.com" value="${esc(cfg.gcalClientId || '')}" />
            </div>
            <div style="font-size:.72rem;color:var(--muted);margin-bottom:.5rem">console.cloud.google.com &gt; APIs &gt; Credentials &gt; OAuth 2.0 Client ID</div>
            <button class="settings-save-btn" id="cal-gcal-connect">Connect Google Calendar</button>
          </div>`
      }
    </div>`;

    // Outlook / Microsoft 365
    html += `<div class="settings-cal-card">
      <div class="settings-cal-header">
        <span class="settings-cal-icon">${outlookIcon()}</span>
        <strong>Outlook / Microsoft 365</strong>
        <span class="settings-cal-badge ${conn.outlook ? 'settings-cal-badge--on' : conn.outlookIcs ? 'settings-cal-badge--on' : ''}">${conn.outlook ? 'Connected (API)' : conn.outlookIcs ? 'Imported' : 'Not connected'}</span>
      </div>
      <div style="margin-top:.5rem">
        <div style="font-size:.78rem;color:var(--muted);margin-bottom:.5rem">
          Paste your published Outlook calendar link (HTML or ICS — both work).
        </div>
        <div style="display:flex;gap:.35rem;margin-bottom:.5rem">
          <input type="text" id="cal-outlook-ics-url" placeholder="https://outlook.office365.com/owa/calendar/.../calendar.html" value="${esc(cfg.outlookIcsUrl || '')}" style="flex:1;padding:.4rem .5rem;background:var(--bg);border:1px solid rgba(255,255,255,.1);border-radius:6px;color:var(--text);font-size:.82rem" />
          <button class="settings-save-btn" id="cal-outlook-ics-fetch" style="width:auto;padding:.4rem .75rem;font-size:.82rem">Fetch</button>
        </div>
        <details style="margin-top:.35rem">
          <summary style="color:var(--muted);font-size:.78rem;cursor:pointer">Alternative: Import .ics file</summary>
          <div style="margin-top:.35rem;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
            <label class="settings-save-btn" style="cursor:pointer;display:inline-block;width:auto;padding:.45rem .75rem;font-size:.82rem">
              Import Outlook .ics File
              <input type="file" id="cal-outlook-ics-file" accept=".ics,.ical" hidden />
            </label>
            ${conn.outlookIcs ? `<button class="settings-save-btn" id="cal-outlook-ics-clear" style="background:#f44336;width:auto;padding:.45rem .75rem;font-size:.82rem">Clear</button>` : ''}
          </div>
        </details>
        <details style="margin-top:.35rem">
          <summary style="color:var(--muted);font-size:.78rem;cursor:pointer">Advanced: OAuth API</summary>
          <div style="margin-top:.35rem">
            ${conn.outlook
              ? `<button class="settings-save-btn" id="cal-msal-disconnect" style="background:#f44336">Disconnect API</button>`
              : `<div class="settings-field" style="margin-bottom:.35rem">
                  <label>Azure App (Client) ID</label>
                  <input type="text" id="cal-msal-client-id" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="${esc(cfg.msalClientId || '')}" />
                </div>
                <div style="font-size:.72rem;color:var(--muted);margin-bottom:.35rem">portal.azure.com &gt; App registrations &gt; New &gt; SPA redirect</div>
                <button class="settings-save-btn" id="cal-msal-connect" style="font-size:.82rem">Connect via OAuth</button>`
            }
          </div>
        </details>
      </div>
    </div>`;

    // Apple Calendar (ICS)
    html += `<div class="settings-cal-card">
      <div class="settings-cal-header">
        <span class="settings-cal-icon">${appleIcon()}</span>
        <strong>Apple Calendar</strong>
        <span class="settings-cal-badge ${cfg.icsUrl ? 'settings-cal-badge--on' : ''}">${cfg.icsUrl ? 'Connected (ICS)' : 'File / URL'}</span>
      </div>
      <div style="margin-top:.5rem">
        <div style="font-size:.78rem;color:var(--muted);margin-bottom:.5rem">Export from Calendar app (File &gt; Export) or publish via iCloud (Share &gt; Public Calendar &gt; copy URL).</div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.5rem">
          <label class="settings-save-btn" style="cursor:pointer;display:inline-block;width:auto;padding:.45rem .75rem;font-size:.82rem">
            Import .ics File
            <input type="file" id="cal-ics-file" accept=".ics,.ical" hidden />
          </label>
        </div>
        <div style="display:flex;gap:.35rem">
          <input type="text" id="cal-ics-url" placeholder="https://p##-caldav.icloud.com/..." value="${esc(cfg.icsUrl || '')}" style="flex:1;padding:.4rem .5rem;background:var(--bg);border:1px solid rgba(255,255,255,.1);border-radius:6px;color:var(--text);font-size:.82rem" />
          <button class="settings-save-btn" id="cal-ics-fetch" style="width:auto;padding:.4rem .75rem;font-size:.82rem">Fetch</button>
          ${cfg.icsUrl ? `<button class="settings-save-btn" id="cal-ics-clear" style="background:#f44336;width:auto;padding:.4rem .75rem;font-size:.82rem">Clear</button>` : ''}
        </div>
      </div>
    </div>`;

    html += '</div>'; // end providers

    // Auto-refresh settings
    const refreshOpts = [
      { val: 0, label: 'Disabled' },
      { val: 15, label: '15 minutes' },
      { val: 30, label: '30 minutes' },
      { val: 60, label: '1 hour' },
      { val: 120, label: '2 hours' },
      { val: 240, label: '4 hours' }
    ];
    html += `<h3>Sync Settings</h3>
      <div class="settings-toggle-row">
        <div>
          <div class="settings-toggle-label">Auto-Refresh Interval</div>
          <div class="settings-toggle-sub">How often to re-fetch calendar events</div>
        </div>
        <select id="cal-refresh-interval" style="padding:.35rem .5rem;background:var(--bg);border:1px solid rgba(255,255,255,.1);border-radius:6px;color:var(--text);font-size:.82rem">
          ${refreshOpts.map(o => `<option value="${o.val}" ${cfg.autoRefreshMinutes === o.val ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
      </div>
      <div class="settings-toggle-row">
        <div>
          <div class="settings-toggle-label">Sync to Huddle</div>
          <div class="settings-toggle-sub">Auto-block calendar events as blackout times in your Huddle schedule</div>
        </div>
        ${toggleHTML('cal-huddle-sync', cfg.huddle?.autoBlock)}
      </div>
      <button class="settings-save-btn" id="save-cal-btn" style="margin-top:.75rem">Save Calendar Settings</button>
      <div id="cal-status"></div>`;

    return html;
  }

  function wireCalendar() {
    const cal = McgheeLab.CalendarService;
    if (!cal) return;

    // Google Calendar
    document.getElementById('cal-gcal-connect')?.addEventListener('click', async () => {
      const clientId = document.getElementById('cal-gcal-client-id')?.value?.trim();
      if (!clientId) { showStatus('cal-status', 'Enter your OAuth Client ID', 'error'); return; }
      try {
        await cal.connectGoogle(clientId);
        render(); wire();
        showStatus('cal-status', 'Google Calendar connected', 'success');
      } catch (err) {
        showStatus('cal-status', 'Google OAuth error: ' + err.message, 'error');
      }
    });
    document.getElementById('cal-gcal-disconnect')?.addEventListener('click', () => {
      cal.disconnectGoogle();
      render(); wire();
      showStatus('cal-status', 'Google Calendar disconnected', 'success');
    });

    // Outlook OAuth
    document.getElementById('cal-msal-connect')?.addEventListener('click', async () => {
      const clientId = document.getElementById('cal-msal-client-id')?.value?.trim();
      if (!clientId) { showStatus('cal-status', 'Enter your Azure App ID', 'error'); return; }
      try {
        await cal.connectOutlook(clientId);
        render(); wire();
        showStatus('cal-status', 'Outlook connected', 'success');
      } catch (err) {
        showStatus('cal-status', 'Outlook auth error: ' + (err.message || err), 'error');
      }
    });
    document.getElementById('cal-msal-disconnect')?.addEventListener('click', () => {
      cal.disconnectOutlook();
      render(); wire();
      showStatus('cal-status', 'Outlook disconnected', 'success');
    });

    // Outlook ICS file
    document.getElementById('cal-outlook-ics-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const result = await cal.importICSFile(file, 'outlook_ics');
        render(); wire();
        showStatus('cal-status', `Imported ${result.count} Outlook event${result.count !== 1 ? 's' : ''}`, 'success');
      } catch (err) {
        showStatus('cal-status', 'Failed to parse file: ' + err.message, 'error');
      }
    });
    document.getElementById('cal-outlook-ics-clear')?.addEventListener('click', () => {
      cal.clearProvider('outlook_ics');
      cal.saveConfig({ outlookIcsUrl: '' });
      render(); wire();
      showStatus('cal-status', 'Outlook ICS cleared', 'success');
    });

    // Outlook ICS URL
    document.getElementById('cal-outlook-ics-fetch')?.addEventListener('click', async () => {
      const url = document.getElementById('cal-outlook-ics-url')?.value?.trim();
      if (!url) { showStatus('cal-status', 'Paste your Outlook ICS link', 'error'); return; }
      const btn = document.getElementById('cal-outlook-ics-fetch');
      if (btn) { btn.disabled = true; btn.textContent = 'Fetching...'; }
      try {
        await cal.saveConfig({ outlookIcsUrl: url });
        const result = await cal.fetchICSFromUrl(url, 'outlook_ics');
        render(); wire();
        showStatus('cal-status', `Outlook ICS fetched — ${result.count} event${result.count !== 1 ? 's' : ''} loaded`, 'success');
      } catch (err) {
        if (btn) { btn.disabled = false; btn.textContent = 'Fetch'; }
        showStatus('cal-status', 'Failed to fetch ICS: ' + (err.message || 'CORS or network error — try importing the .ics file directly instead'), 'error');
      }
    });

    // Apple Calendar ICS file
    document.getElementById('cal-ics-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const result = await cal.importICSFile(file, 'ics');
        render(); wire();
        showStatus('cal-status', `Imported ${result.count} event${result.count !== 1 ? 's' : ''}`, 'success');
      } catch (err) {
        showStatus('cal-status', 'Failed to parse file: ' + err.message, 'error');
      }
    });
    document.getElementById('cal-ics-fetch')?.addEventListener('click', async () => {
      const url = document.getElementById('cal-ics-url')?.value?.trim();
      if (!url) { showStatus('cal-status', 'Enter an ICS URL', 'error'); return; }
      const btn = document.getElementById('cal-ics-fetch');
      if (btn) { btn.disabled = true; btn.textContent = 'Fetching...'; }
      try {
        await cal.saveConfig({ icsUrl: url });
        const result = await cal.fetchICSFromUrl(url, 'ics');
        render(); wire();
        showStatus('cal-status', `ICS fetched — ${result.count} event${result.count !== 1 ? 's' : ''} loaded`, 'success');
      } catch (err) {
        if (btn) { btn.disabled = false; btn.textContent = 'Fetch'; }
        showStatus('cal-status', 'Failed to fetch ICS: ' + (err.message || 'CORS or network error — try importing the .ics file directly'), 'error');
      }
    });
    document.getElementById('cal-ics-clear')?.addEventListener('click', () => {
      cal.clearProvider('ics');
      cal.saveConfig({ icsUrl: '' });
      render(); wire();
      showStatus('cal-status', 'Apple ICS cleared', 'success');
    });

    // Save calendar settings (refresh interval + huddle sync)
    document.getElementById('save-cal-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('save-cal-btn');
      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        const refreshMinutes = parseInt(document.getElementById('cal-refresh-interval')?.value) || 0;
        const huddleSync = isChecked('cal-huddle-sync');
        await cal.saveConfig({
          autoRefreshMinutes: refreshMinutes,
          huddle: { autoBlock: huddleSync }
        });
        cal.startAutoRefresh(refreshMinutes);
        showStatus('cal-status', 'Calendar settings saved', 'success');
      } catch (err) {
        showStatus('cal-status', 'Failed to save: ' + err.message, 'error');
      }
      btn.disabled = false;
      btn.textContent = 'Save Calendar Settings';
    });
  }

  // SVG icons for calendar providers
  function googleIcon() { return '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>'; }
  function outlookIcon() { return '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="#0078D4" d="M24 7.387v10.478c0 .23-.08.424-.238.583a.793.793 0 01-.583.238h-8.87V6.565h8.87c.23 0 .424.08.583.238.159.159.238.353.238.583z"/><path fill="#0364B8" d="M14.309 6.565v12.122L0 16.58V4.674l14.309 1.891z"/><ellipse fill="#fff" cx="7.155" cy="11.626" rx="3.46" ry="3.98"/><ellipse fill="#0078D4" cx="7.155" cy="11.626" rx="2.38" ry="2.93"/></svg>'; }
  function appleIcon() { return '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>'; }

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

  function testNotifBtn(type, label) {
    return `<button class="settings-save-btn test-notif-btn" data-type="${type}" style="width:auto;padding:.4rem .75rem;font-size:.82rem;margin:.25rem">${label}</button>`;
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
