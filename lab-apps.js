/* ================================================================
   lab-apps.js — McGheeLab Internal Lab Apps Hub
   Private section for authenticated lab members only.
   Apps are standalone (own index.html) and embedded via iframe.
   Supports split-view: two apps side-by-side with draggable divider.
   ================================================================ */

window.McgheeLab = window.McgheeLab || {};

/* ─── App Registry ──────────────────────────────────────────── */
const LAB_APPS = [
  {
    id: 'inventory',
    name: 'Inventory Tracker',
    description: 'Track lab supplies, reagents, and equipment. Log usage, set reorder alerts, and manage vendors.',
    path: 'apps/inventory/index.html',
    icon: `<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
      <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
      <line x1="12" y1="22.08" x2="12" y2="12"/>
    </svg>`,
    status: 'coming-soon',
    adminOnly: false
  },
  {
    id: 'equipment',
    name: 'Equipment Scheduler',
    description: 'Book microscopes, printers, and shared equipment. Syncs with Google Calendar for real-time availability.',
    path: 'apps/equipment/index.html',
    icon: `<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
      <circle cx="12" cy="16" r="2"/>
    </svg>`,
    status: 'active',
    adminOnly: false
  },
  {
    id: 'meetings',
    name: 'Lab Meeting',
    description: 'Schedule presentations, manage agendas, share notes, and track action items from weekly lab meetings.',
    path: 'apps/meetings/index.html',
    icon: `<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>`,
    status: 'active',
    adminOnly: false
  },
  {
    id: 'console',
    name: 'Admin Console',
    description: 'Master control panel for all lab apps. Manage permissions, configure integrations, and monitor usage.',
    path: 'apps/console/index.html',
    icon: `<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>`,
    status: 'coming-soon',
    adminOnly: true
  },
  {
    id: 'activity-tracker',
    name: 'Activity Tracker',
    description: 'Log daily activities, categorize tasks, track time, and view trends. ML and AI-powered categorization with milestone tracking for annual reviews.',
    path: 'apps/activity-tracker/index.html',
    icon: `<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 20V10"/>
      <path d="M18 20V4"/>
      <path d="M6 20v-4"/>
      <circle cx="12" cy="7" r="2"/>
      <path d="M3 3l3 3"/>
      <path d="M21 3l-3 3"/>
    </svg>`,
    status: 'active',
    adminOnly: false
  },
  {
    id: 'huddle',
    name: 'The Huddle',
    description: 'Weekly planning board. Share what protocols you\'re running so others can watch or join.',
    path: 'apps/huddle/index.html',
    icon: `<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      <line x1="12" y1="17" x2="12" y2="21"/>
      <line x1="10" y1="19" x2="14" y2="19"/>
    </svg>`,
    status: 'active',
    adminOnly: false
  },
  {
    id: 'scheduler',
    name: 'Scheduler',
    description: 'Create scheduling tasks, invite participants via private link, and manage sessions or freeform availability.',
    path: 'apps/scheduler/index.html',
    icon: `<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
      <path d="M8 14h.01"/>
      <path d="M12 14h.01"/>
      <path d="M16 14h.01"/>
      <path d="M8 18h.01"/>
      <path d="M12 18h.01"/>
    </svg>`,
    status: 'active',
    adminOnly: false
  },
  {
    id: 'chat',
    name: 'Lab Chat',
    description: 'Real-time messaging for the lab. Channels, DMs, threads, file sharing, and reactions.',
    path: 'apps/chat/index.html',
    icon: `<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      <line x1="9" y1="10" x2="15" y2="10"/>
      <line x1="9" y1="14" x2="13" y2="14"/>
    </svg>`,
    status: 'active',
    adminOnly: false
  },
  {
    id: 'settings',
    name: 'Settings',
    description: 'Notification preferences, profile, and app administration.',
    path: 'apps/settings/index.html',
    icon: `<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1.08-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1.08 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
    </svg>`,
    status: 'active',
    adminOnly: false
  }
];

/* ─── State ────────────────────────────────────────────────── */
let _splitAppId = null;   // second pane app id, null = single view
let _splitRatio = 0.5;    // fraction of width for left pane (0.2–0.8)
let _authEverResolved = false; // true once Auth.currentUser has been non-null
let _authRedirectTimer = null; // delayed redirect to login (prevents race condition)

/* ─── Hub Page ──────────────────────────────────────────────── */

function renderLabApps() {
  const Auth = window.McgheeLab?.Auth;
  if (!Auth?.currentUser) {
    // Auth may still be resolving — always show loading and let Auth.onChange re-render.
    // Only redirect to login if auth has resolved AND the user is definitively signed out.
    if (!_authEverResolved || Auth?._authStateResolved === false) {
      return '<div class="lab-apps-page"><p style="text-align:center;color:#8a94a6;padding:3rem">Loading&hellip;</p></div>';
    }
    // Auth resolved but user is null — genuinely signed out. Wait a moment before redirecting
    // in case auth is briefly null during navigation.
    if (!_authRedirectTimer) {
      _authRedirectTimer = setTimeout(() => {
        _authRedirectTimer = null;
        const Auth2 = window.McgheeLab?.Auth;
        if (!Auth2?.currentUser) {
          window.location.hash = '#/login';
        }
      }, 1500);
    }
    return '<div class="lab-apps-page"><p style="text-align:center;color:#8a94a6;padding:3rem">Loading&hellip;</p></div>';
  }
  if (_authRedirectTimer) { clearTimeout(_authRedirectTimer); _authRedirectTimer = null; }
  _authEverResolved = true;
  if (Auth.isGuest()) {
    window.location.hash = '#/dashboard';
    return '<p>Access denied.</p>';
  }

  const isAdmin = Auth.isAdmin();
  const apps = LAB_APPS.filter(a => !a.adminOnly || isAdmin);

  const installBanner = typeof window.mcgheeGetInstallBanner === 'function'
    ? window.mcgheeGetInstallBanner() : '';
  const notifPrompt = typeof window.mcgheeGetNotificationPrompt === 'function'
    ? window.mcgheeGetNotificationPrompt() : '';

  return `
    <div class="lab-apps-page">
      ${installBanner}
      ${notifPrompt}
      <div class="lab-apps-header">
        <h2>Lab Apps</h2>
        <p class="lab-apps-subtitle">Internal tools for McGheeLab members</p>
      </div>
      <div class="lab-apps-grid">
        ${apps.map(app => `
          <a href="#/apps/${app.id}" class="lab-app-card" data-app="${app.id}">
            <div class="lab-app-icon">${app.icon}</div>
            <h3 class="lab-app-name">${app.name}</h3>
            <p class="lab-app-desc">${app.description}</p>
            <span class="lab-app-status lab-app-status--${app.status}">
              ${app.status === 'coming-soon' ? 'Coming Soon' : 'Active'}
            </span>
            ${app.adminOnly ? '<span class="lab-app-badge-admin">Admin</span>' : ''}
          </a>
        `).join('')}
      </div>
    </div>`;
}

function wireLabApps() {
  _splitAppId = null;
  _splitRatio = 0.5;
}

/* ─── Embedded App (iframe) with split-view ────────────────── */

function renderLabApp(appId) {
  const Auth = window.McgheeLab?.Auth;
  if (!Auth?.currentUser) {
    // Always show loading — never immediately redirect. Auth may be briefly null during navigation.
    if (!_authRedirectTimer) {
      _authRedirectTimer = setTimeout(() => {
        _authRedirectTimer = null;
        if (!window.McgheeLab?.Auth?.currentUser) {
          window.location.hash = '#/login';
        }
      }, 1500);
    }
    return '<div class="lab-apps-page lab-apps-page--embedded"><div style="display:flex;align-items:center;justify-content:center;flex:1;color:#8a94a6">Loading&hellip;</div></div>';
  }
  if (_authRedirectTimer) { clearTimeout(_authRedirectTimer); _authRedirectTimer = null; }
  _authEverResolved = true;
  if (Auth.isGuest()) {
    window.location.hash = '#/dashboard';
    return '<p>Access denied.</p>';
  }

  const app = LAB_APPS.find(a => a.id === appId);
  if (!app) return null;

  if (app.adminOnly && !Auth.isAdmin()) {
    window.location.hash = '#/apps';
    return '<p>Access denied.</p>';
  }

  return buildEmbeddedHTML(appId);
}

/* Builds the embedded HTML without auth checks — safe for rerender */
function buildEmbeddedHTML(appId) {
  const app = LAB_APPS.find(a => a.id === appId);
  if (!app) return null;
  const Auth = window.McgheeLab?.Auth;
  const isAdmin = Auth?.isAdmin?.() || false;
  const visibleApps = LAB_APPS.filter(a => a.status === 'active' && (!a.adminOnly || isAdmin));
  const splitApp = _splitAppId ? LAB_APPS.find(a => a.id === _splitAppId) : null;
  const hasSplit = !!splitApp;
  const leftPct = hasSplit ? (_splitRatio * 100).toFixed(1) : 100;

  // SVG icons for the bottom bar
  const svgSplit = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg>';
  const svgX = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  return `
    <div class="lab-apps-page lab-apps-page--embedded${hasSplit ? ' lab-apps-page--split' : ''}">
      <div class="lab-app-panes">
        <div class="lab-app-pane lab-app-pane--left" id="lab-app-pane-left" style="flex:${leftPct}">
          <iframe
            id="lab-app-frame"
            class="lab-app-iframe"
            src="${app.path}"
            data-app-id="${app.id}"
            title="${app.name}"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
            loading="eager"
          ></iframe>
        </div>
        ${hasSplit ? `
          <div class="lab-app-divider" id="lab-app-divider" title="Drag to resize">
            <div class="lab-app-divider-grip"></div>
          </div>
          <div class="lab-app-pane lab-app-pane--right" id="lab-app-pane-right" style="flex:${(100 - leftPct).toFixed(1)}">
            <button class="lab-app-pane-close" id="lab-app-pane-close" title="Close split">${svgX}</button>
            <iframe
              id="lab-app-frame-2"
              class="lab-app-iframe"
              src="${splitApp.path}"
              data-app-id="${splitApp.id}"
              title="${splitApp.name}"
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
              loading="eager"
            ></iframe>
          </div>
        ` : ''}
      </div>
      <nav class="lab-app-bottom-nav" id="lab-app-bottom-nav">
        <div class="lab-app-bottom-apps">
          ${visibleApps.map(a => {
            const isLeft = a.id === appId;
            const isRight = hasSplit && a.id === _splitAppId;
            const cls = isLeft ? ' lab-app-bottom-item--active' : isRight ? ' lab-app-bottom-item--split' : '';
            return `<a class="lab-app-bottom-item${cls}" href="#/apps/${a.id}" data-nav-app="${a.id}">
              <span class="lab-app-bottom-icon">${a.icon}</span>
              <span class="lab-app-bottom-label">${a.name}</span>
            </a>`;
          }).join('')}
        </div>
        <button class="lab-app-split-btn" id="lab-app-split-btn" title="${hasSplit ? 'Close split view' : 'Open split view'}">
          ${svgSplit}
        </button>
      </nav>
    </div>`;
}

function wireLabApp(appId) {
  // Read auth state FRESH each time we send to iframe (not cached at wire time)
  function buildAuthPayload() {
    const Auth = window.McgheeLab?.Auth;
    const user = Auth?.currentUser;
    const profile = Auth?.currentProfile;
    return {
      type: 'mcgheelab-auth',
      token: null,
      user: user ? { uid: user.uid, email: user.email, displayName: user.displayName } : null,
      profile: profile || null
    };
  }

  function sendAuthToFrame(iframe) {
    if (!iframe) return;
    try { iframe.contentWindow.postMessage(buildAuthPayload(), window.location.origin); }
    catch (e) { /* not ready */ }
  }

  // Auth for primary frame
  const iframe = document.getElementById('lab-app-frame');
  if (iframe) {
    const doSend = () => {
      sendAuthToFrame(iframe);
      setTimeout(() => sendAuthToFrame(iframe), 200);
      setTimeout(() => sendAuthToFrame(iframe), 600);
      setTimeout(() => sendAuthToFrame(iframe), 1500);
    };
    iframe.addEventListener('load', doSend);
    window.addEventListener('message', function onMsg(e) {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type !== 'mcgheelab-app-ready') return;
      sendAuthToFrame(iframe);
    });
  }

  // Auth for split frame
  const iframe2 = document.getElementById('lab-app-frame-2');
  if (iframe2) {
    const doSend2 = () => {
      sendAuthToFrame(iframe2);
      setTimeout(() => sendAuthToFrame(iframe2), 200);
      setTimeout(() => sendAuthToFrame(iframe2), 600);
      setTimeout(() => sendAuthToFrame(iframe2), 1500);
    };
    iframe2.addEventListener('load', doSend2);
    window.addEventListener('message', function onMsg2(e) {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type !== 'mcgheelab-app-ready') return;
      sendAuthToFrame(iframe2);
    });
  }

  // Draggable divider
  wireDivider();

  // Split button
  const splitBtn = document.getElementById('lab-app-split-btn');
  if (splitBtn) {
    splitBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (_splitAppId) {
        // Close split
        _splitAppId = null;
        _splitRatio = 0.5;
      } else {
        // Open split — pick first non-active app
        const visibleApps = LAB_APPS.filter(a => a.status === 'active' && a.id !== appId);
        if (visibleApps.length > 0) _splitAppId = visibleApps[0].id;
      }
      rerender(appId);
    });
  }

  // Close split pane button
  const closeBtn = document.getElementById('lab-app-pane-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      _splitAppId = null;
      _splitRatio = 0.5;
      rerender(appId);
    });
  }

  // Bottom nav: clicking a different app opens it in split pane (or switches primary)
  document.querySelectorAll('[data-nav-app]').forEach(el => {
    el.addEventListener('click', (e) => {
      const targetId = el.dataset.navApp;
      if (targetId === appId) {
        // Clicking active app — no-op or close split
        if (_splitAppId) {
          e.preventDefault();
          _splitAppId = null;
          _splitRatio = 0.5;
          rerender(appId);
        }
        return;
      }
      if (_splitAppId === targetId) {
        // Clicking the split app — make it the primary
        // Let the hash navigation handle it naturally
        _splitAppId = appId; // old primary becomes split
        return;
      }
      if (_splitAppId) {
        // Already in split — replace the right pane
        e.preventDefault();
        _splitAppId = targetId;
        rerender(appId);
        return;
      }
      // Not in split — normal navigation (hash link)
    });
  });
}

function rerender(appId) {
  const html = buildEmbeddedHTML(appId);
  if (!html) return;
  const container = document.querySelector('.lab-apps-page--embedded');
  if (!container) return;
  container.outerHTML = html;
  wireLabApp(appId);
}

/* ─── Draggable Divider ────────────────────────────────────── */

function wireDivider() {
  const divider = document.getElementById('lab-app-divider');
  const leftPane = document.getElementById('lab-app-pane-left');
  const rightPane = document.getElementById('lab-app-pane-right');
  const container = document.querySelector('.lab-app-panes');
  if (!divider || !leftPane || !rightPane || !container) return;

  let dragging = false;

  divider.addEventListener('mousedown', startDrag);
  divider.addEventListener('touchstart', startDrag, { passive: false });

  function startDrag(e) {
    e.preventDefault();
    dragging = true;
    divider.classList.add('lab-app-divider--active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    // Cover iframes to capture pointer events
    leftPane.style.pointerEvents = 'none';
    rightPane.style.pointerEvents = 'none';

    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', stopDrag);
    document.addEventListener('touchmove', onDrag, { passive: false });
    document.addEventListener('touchend', stopDrag);
  }

  function onDrag(e) {
    if (!dragging) return;
    e.preventDefault();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const rect = container.getBoundingClientRect();
    let ratio = (clientX - rect.left) / rect.width;
    ratio = Math.max(0.2, Math.min(0.8, ratio));
    _splitRatio = ratio;
    const leftPct = (ratio * 100).toFixed(1);
    const rightPct = ((1 - ratio) * 100).toFixed(1);
    leftPane.style.flex = leftPct;
    rightPane.style.flex = rightPct;
  }

  function stopDrag() {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('lab-app-divider--active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    leftPane.style.pointerEvents = '';
    rightPane.style.pointerEvents = '';

    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', stopDrag);
    document.removeEventListener('touchmove', onDrag);
    document.removeEventListener('touchend', stopDrag);
  }

  // Double-click divider to reset to 50/50
  divider.addEventListener('dblclick', () => {
    _splitRatio = 0.5;
    leftPane.style.flex = '50';
    rightPane.style.flex = '50';
  });
}

/* ─── Exports ───────────────────────────────────────────────── */
McgheeLab.renderLabApps = renderLabApps;
McgheeLab.wireLabApps   = wireLabApps;
McgheeLab.renderLabApp  = renderLabApp;
McgheeLab.wireLabApp    = wireLabApp;
McgheeLab.LAB_APPS      = LAB_APPS;
