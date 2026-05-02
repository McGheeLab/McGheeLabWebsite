/* profile.js — renders the three-section Profile page:
 *   1. Google sign-in (Firebase) — reuses firebridge.
 *   2. Outlook calendar ICS URL — editable input, saves to data/calendar/outlook.json.
 *   3. Outlook mail sign-in — MSAL device-code flow driven from the browser.
 */

const PROFILE = {
  state: null,
  authFlow: null,      // { flow_id, user_code, verification_uri, pollTimer, modal }
};

document.addEventListener('DOMContentLoaded', async () => {
  await loadProfileState();
  render();
  // Keep the Google section in sync with firebridge's async auth resolution.
  if (window.firebridge) {
    firebridge.onAuth(() => renderGoogleCard());
  }
});

async function loadProfileState() {
  try {
    const res = await fetch('/api/profile-state');
    PROFILE.state = await res.json();
  } catch (e) {
    PROFILE.state = { error: e.message };
  }
}

function render() {
  const host = document.getElementById('profile-grid');
  host.innerHTML = '';
  host.appendChild(googleCard());
  host.appendChild(outlookCalendarCard());
  host.appendChild(gmailMailCard());
  host.appendChild(outlookMailCard());
}

function renderGoogleCard() {
  const host = document.getElementById('profile-grid');
  if (!host) return;
  const existing = host.querySelector('[data-card=google]');
  const fresh = googleCard();
  if (existing) host.replaceChild(fresh, existing);
  else host.prepend(fresh);
}

/* ---------- Section 1: Google ---------- */

function googleCard() {
  const card = document.createElement('div');
  card.className = 'profile-card';
  card.dataset.card = 'google';
  card.innerHTML = `<h2>Google sign-in</h2>`;

  const user = window.firebridge?.getUser?.();
  if (user) {
    const profile = window.firebridge?.getProfile?.();
    const role = profile?.role || 'viewer';
    const row = document.createElement('div');
    row.className = 'profile-row';
    row.innerHTML = `
      <span class="lbl">Signed in</span>
      <span>${escapeHtml(user.email || user.displayName || user.uid)}</span>
      <span class="profile-status ok">${escapeHtml(role)}</span>
    `;
    const out = document.createElement('button');
    out.className = 'btn';
    out.textContent = 'Sign out';
    out.addEventListener('click', () => firebridge.signOut());
    row.appendChild(out);
    card.appendChild(row);
  } else {
    const row = document.createElement('div');
    row.className = 'profile-row';
    row.innerHTML = `
      <span class="lbl">Not signed in</span>
      <span class="profile-status off">disconnected</span>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = 'Sign in with Google';
    btn.addEventListener('click', async () => {
      try { await firebridge.signInWithGoogle(); }
      catch (e) { alert('Google sign-in failed: ' + e.message); }
    });
    row.appendChild(btn);
    card.appendChild(row);
  }
  const note = document.createElement('div');
  note.className = 'profile-msg';
  note.textContent = 'Google sign-in uses the McGhee Lab Firebase project. Needed for admin-only writes, activity tracker sync, and profile role checks.';
  card.appendChild(note);
  return card;
}

/* ---------- Section 2: Outlook calendar ICS URL ---------- */

function outlookCalendarCard() {
  const card = document.createElement('div');
  card.className = 'profile-card';
  card.dataset.card = 'calendar';
  card.innerHTML = `<h2>Outlook calendar</h2>`;

  const cal = PROFILE.state?.outlook_calendar || {};
  const row1 = document.createElement('div');
  row1.className = 'profile-row';
  row1.innerHTML = `<span class="lbl">ICS URL</span>`;
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.placeholder = 'https://outlook.office365.com/owa/calendar/.../calendar.ics';
  urlInput.value = cal.ics_url || '';
  row1.appendChild(urlInput);
  card.appendChild(row1);

  const row2 = document.createElement('div');
  row2.className = 'profile-row';
  row2.innerHTML = `<span class="lbl">Label</span>`;
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.placeholder = 'Outlook Calendar';
  labelInput.value = cal.label || '';
  row2.appendChild(labelInput);
  card.appendChild(row2);

  const row3 = document.createElement('div');
  row3.className = 'profile-row';
  row3.innerHTML = `<span class="lbl">Embed URL (optional)</span>`;
  const embedInput = document.createElement('input');
  embedInput.type = 'text';
  embedInput.placeholder = 'https://outlook.office365.com/owa/calendar/.../reachcalendar.html';
  embedInput.value = cal.embed_url || '';
  row3.appendChild(embedInput);
  card.appendChild(row3);

  const actions = document.createElement('div');
  actions.className = 'profile-row';
  const save = document.createElement('button');
  save.className = 'btn btn-primary';
  save.textContent = 'Save';
  const status = document.createElement('span');
  status.className = 'profile-msg';
  status.style.marginTop = '0';
  save.addEventListener('click', async () => {
    status.textContent = 'saving\u2026';
    try {
      const res = await fetch('/api/calendar/outlook-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ics_url: urlInput.value.trim(),
          label: labelInput.value.trim() || 'Outlook Calendar',
          embed_url: embedInput.value.trim(),
        }),
      });
      const j = await res.json();
      if (!j.ok) { status.textContent = 'failed: ' + (j.error || ''); return; }
      status.textContent = 'saved.';
      await loadProfileState();
      setTimeout(() => { status.textContent = ''; }, 3000);
    } catch (e) {
      status.textContent = 'error: ' + e.message;
    }
  });
  actions.appendChild(save);
  actions.appendChild(status);
  card.appendChild(actions);

  const note = document.createElement('div');
  note.className = 'profile-msg';
  note.innerHTML = 'The ICS URL is how <code>calendar_scrape.py</code> pulls your Outlook events. '
    + 'Get it from Outlook on the web: Settings \u2192 Calendar \u2192 Shared calendars \u2192 Publish a calendar \u2192 copy the ICS link.';
  card.appendChild(note);
  return card;
}

/* ---------- Section 3: Gmail via Google Sign-In ---------- *
 *
 * Phase-7 update (2026-05): the per-user Gmail OAuth flow now lives at
 * /pages/settings.html → Google Connections, backed by the Cloud Function
 * `exchangeOAuthCode` (refresh-token based, deploy-safe). This legacy card
 * pushed an access token to server.py's /api/gmail/set-google-token, which
 * doesn't exist on the static deploy (causes "Unexpected token <" JSON-parse
 * errors). We render a redirect pointer instead so users land on the new
 * flow.
 */

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

function gmailMailCard() {
  const card = document.createElement('div');
  card.className = 'profile-card';
  card.dataset.card = 'gmail';
  card.innerHTML = `<h2>Gmail</h2>`;

  const row = document.createElement('div');
  row.className = 'profile-row';
  row.innerHTML = `
    <span class="lbl">Moved</span>
    <span>Gmail integration is now managed in
      <a href="/rm/pages/settings.html#connections">Settings → Google Connections</a>.</span>
  `;
  card.appendChild(row);
  const note = document.createElement('div');
  note.className = 'profile-msg';
  note.innerHTML = 'New flow uses per-user refresh tokens stored in Firestore and a scheduled Cloud Function scraper. ' +
    'Works on the deploy without server.py.';
  card.appendChild(note);
  return card;
}

// Stub: legacy callers still reference this; route them to settings.
function _legacy_gmailMailCard_unused() {
  const card = document.createElement('div');
  card.className = 'profile-card';
  card.dataset.card = 'gmail';
  card.innerHTML = `<h2>Gmail (legacy view, hidden)</h2>`;

  const g = PROFILE.state?.gmail_mail || {};
  const fresh = g.connected && g.auth === 'oauth' && g.expires_at && (g.expires_at * 1000 > Date.now());
  const expired = g.auth === 'oauth' && g.expires_at && (g.expires_at * 1000 <= Date.now());

  const row = document.createElement('div');
  row.className = 'profile-row';
  if (fresh) {
    const mins = Math.max(0, Math.round((g.expires_at * 1000 - Date.now()) / 60000));
    row.innerHTML = `
      <span class="lbl">Signed in</span>
      <span>${escapeHtml(g.email || '')}</span>
      <span class="profile-status ok">connected</span>
      <span class="profile-msg" style="margin:0 0 0 auto">token expires in ${mins} min</span>
    `;
  } else if (expired) {
    row.innerHTML = `
      <span class="lbl">Session expired</span>
      <span>${escapeHtml(g.email || '')}</span>
      <span class="profile-status pending">re-connect</span>
    `;
  } else if (g.auth === 'imap') {
    row.innerHTML = `
      <span class="lbl">Legacy IMAP</span>
      <span>${escapeHtml(g.email || '')}</span>
      <span class="profile-status ok">connected</span>
    `;
  } else {
    row.innerHTML = `
      <span class="lbl">Not connected</span>
      <span class="profile-status off">disconnected</span>
    `;
  }
  card.appendChild(row);

  const actions = document.createElement('div');
  actions.className = 'profile-row';
  const connect = document.createElement('button');
  connect.className = 'btn btn-primary';
  connect.textContent = fresh ? 'Reconnect (refresh token)' : 'Connect Gmail with Google';
  connect.addEventListener('click', connectGmailWithGoogle);
  actions.appendChild(connect);

  if (g.connected || expired) {
    const test = document.createElement('button');
    test.className = 'btn';
    test.textContent = 'Test';
    test.addEventListener('click', async () => {
      const status = actions.querySelector('.profile-msg');
      status.textContent = 'testing\u2026';
      try {
        const r = await fetch('/api/gmail/test', { method: 'POST' });
        const j = await r.json();
        if (!j.ok) { status.textContent = 'failed: ' + (j.error || ''); return; }
        status.textContent = `ok \u2014 ${escapeHtml(j.email_address || j.auth)} \u00b7 ${j.mailbox_size || 0} messages`;
      } catch (e) { status.textContent = 'error: ' + e.message; }
    });
    actions.appendChild(test);

    const out = document.createElement('button');
    out.className = 'btn';
    out.textContent = 'Disconnect';
    out.addEventListener('click', async () => {
      if (!confirm('Disconnect Gmail? Import will stop pulling new messages until you reconnect.')) return;
      try {
        await fetch('/api/gmail/sign-out', { method: 'POST' });
        await loadProfileState();
        render();
      } catch (e) { alert('disconnect failed: ' + e.message); }
    });
    actions.appendChild(out);
  }
  const status = document.createElement('span');
  status.className = 'profile-msg';
  status.style.marginTop = '0';
  actions.appendChild(status);
  card.appendChild(actions);

  const note = document.createElement('div');
  note.className = 'profile-msg';
  note.innerHTML = 'Signs in via Firebase Google Sign-In and requests the <code>gmail.readonly</code> scope. '
    + 'The access token is pushed to the server so <code>gmail_fetch.py</code> can pull new mail with the Gmail REST API. '
    + 'Tokens last ~60 min; the Profile page shows when it\u2019s time to reconnect. '
    + 'No app passwords needed.';
  card.appendChild(note);
  return card;
}

async function connectGmailWithGoogle() {
  if (typeof firebase === 'undefined') {
    alert('Firebase SDK not loaded.'); return;
  }
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.addScope(GMAIL_SCOPE);
  // Force the consent + account picker so the user can choose which Google
  // account to grant Gmail scope to, even if already signed in.
  provider.setCustomParameters({ prompt: 'consent select_account' });
  let result;
  try {
    result = await firebase.auth().signInWithPopup(provider);
  } catch (e) {
    alert('Google sign-in failed: ' + (e.message || e)); return;
  }
  const cred = result.credential;
  const token = cred && cred.accessToken;
  const email = result.user && result.user.email;
  if (!token) { alert('No Google access token returned. Gmail scope may be blocked on this project.'); return; }

  try {
    const r = await fetch('/api/gmail/set-google-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: token, email, expires_in: 3600 }),
    });
    const j = await r.json();
    if (!j.ok) { alert('Failed to save token: ' + (j.error || '')); return; }
    await loadProfileState();
    render();
  } catch (e) {
    alert('Failed to save token: ' + e.message);
  }
}

/* ---------- Section 4: Outlook mail ---------- */

function outlookMailCard() {
  const card = document.createElement('div');
  card.className = 'profile-card';
  card.dataset.card = 'mail';
  card.innerHTML = `<h2>Outlook mail (Microsoft Graph)</h2>`;

  const m = PROFILE.state?.outlook_mail || {};
  const row = document.createElement('div');
  row.className = 'profile-row';
  if (m.connected) {
    row.innerHTML = `
      <span class="lbl">Signed in</span>
      <span>${escapeHtml(m.account || '')}</span>
      <span class="profile-status ok">connected</span>
    `;
    const out = document.createElement('button');
    out.className = 'btn';
    out.textContent = 'Disconnect';
    out.addEventListener('click', async () => {
      if (!confirm('Sign out of Outlook? Next fetch will require re-authentication.')) return;
      try {
        await fetch('/api/outlook/sign-out', { method: 'POST' });
        await loadProfileState();
        render();
      } catch (e) { alert('sign-out failed: ' + e.message); }
    });
    row.appendChild(out);
  } else {
    row.innerHTML = `
      <span class="lbl">Not connected</span>
      <span class="profile-status off">disconnected</span>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = 'Connect Outlook';
    btn.addEventListener('click', startOutlookAuth);
    row.appendChild(btn);
  }
  card.appendChild(row);

  const note = document.createElement('div');
  note.className = 'profile-msg';
  note.textContent = 'Outlook mail sign-in uses Microsoft Graph via MSAL device-code. Grants Mail.Read only. '
    + 'The cached token refreshes for ~90 days so Import can run without re-prompting.';
  card.appendChild(note);
  return card;
}

async function startOutlookAuth() {
  try {
    const res = await fetch('/api/outlook/start-auth', { method: 'POST' });
    const j = await res.json();
    if (!j.ok) { alert('Outlook sign-in failed to start: ' + (j.error || '')); return; }
    PROFILE.authFlow = { flow_id: j.flow_id, user_code: j.user_code, verification_uri: j.verification_uri, expires_in: j.expires_in };
    openAuthModal(j);
  } catch (e) {
    alert('Outlook sign-in failed: ' + e.message);
  }
}

function openAuthModal(flow) {
  const back = document.createElement('div');
  back.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:95;display:flex;align-items:center;justify-content:center';
  const panel = document.createElement('div');
  panel.style.cssText = 'background:#fff;border-radius:10px;min-width:460px;max-width:560px;padding:22px 26px;box-shadow:0 20px 40px rgba(0,0,0,.25);text-align:left';
  panel.innerHTML = `
    <h3 style="margin:0 0 12px 0;font-size:16px">Sign in to Outlook</h3>
    <ol style="margin:0 0 14px 18px;font-size:13px;line-height:1.7">
      <li>Click the link to open Microsoft's sign-in page in a new tab.</li>
      <li>Paste the code below and sign in with your Outlook account.</li>
      <li>This page will update automatically when it's done.</li>
    </ol>
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px;flex-wrap:wrap">
      <a href="${flow.verification_uri}" target="_blank" rel="noopener" class="btn btn-primary" style="text-decoration:none">Open sign-in page \u2192</a>
      <span class="profile-code" id="auth-code">${escapeHtml(flow.user_code)}</span>
    </div>
    <div id="auth-status" class="profile-msg">waiting for sign-in\u2026</div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button class="btn" data-k="cancel">Cancel</button>
    </div>
  `;
  back.appendChild(panel);
  document.body.appendChild(back);
  const close = () => {
    if (PROFILE.authFlow?.pollTimer) clearInterval(PROFILE.authFlow.pollTimer);
    PROFILE.authFlow = null;
    if (back.parentNode) document.body.removeChild(back);
  };
  panel.querySelector('[data-k=cancel]').addEventListener('click', close);
  back.addEventListener('click', (ev) => { if (ev.target === back) close(); });

  const statusEl = panel.querySelector('#auth-status');
  const pollTimer = setInterval(async () => {
    try {
      const r = await fetch(`/api/outlook/auth-poll?flow_id=${encodeURIComponent(flow.flow_id)}`);
      if (!r.ok) { statusEl.textContent = 'poll failed: HTTP ' + r.status; return; }
      const s = await r.json();
      if (s.status === 'done') {
        statusEl.textContent = 'connected!';
        clearInterval(pollTimer);
        setTimeout(async () => {
          close();
          await loadProfileState();
          render();
        }, 600);
      } else if (s.status === 'failed') {
        statusEl.textContent = 'sign-in failed: ' + (s.error || 'unknown error');
        clearInterval(pollTimer);
      }
    } catch (e) {
      statusEl.textContent = 'poll error: ' + e.message;
    }
  }, 3000);
  PROFILE.authFlow.pollTimer = pollTimer;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
