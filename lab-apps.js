/* ================================================================
   lab-apps.js — McGheeLab Internal Lab Apps Hub
   Private section for authenticated lab members only.
   Apps are standalone (own index.html) and embedded via iframe.
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
    status: 'coming-soon',
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
    status: 'coming-soon',
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
  }
];

/* ─── Hub Page ──────────────────────────────────────────────── */

function renderLabApps() {
  const Auth = window.McgheeLab?.Auth;
  if (!Auth?.currentUser) {
    window.location.hash = '#/login';
    return '<p>Redirecting&hellip;</p>';
  }
  if (Auth.isGuest()) {
    window.location.hash = '#/dashboard';
    return '<p>Access denied.</p>';
  }

  const isAdmin = Auth.isAdmin();
  const apps = LAB_APPS.filter(a => !a.adminOnly || isAdmin);

  return `
    <div class="lab-apps-page">
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
  // Hub page — no extra wiring needed yet
}

/* ─── Embedded App (iframe) ─────────────────────────────────── */

function renderLabApp(appId) {
  const Auth = window.McgheeLab?.Auth;
  if (!Auth?.currentUser) {
    window.location.hash = '#/login';
    return '<p>Redirecting&hellip;</p>';
  }
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

  return `
    <div class="lab-apps-page lab-apps-page--embedded">
      <nav class="lab-app-breadcrumb">
        <a href="#/apps">Lab Apps</a>
        <span class="lab-app-breadcrumb-sep">/</span>
        <span>${app.name}</span>
      </nav>
      <div class="lab-app-iframe-wrap">
        <iframe
          id="lab-app-frame"
          class="lab-app-iframe"
          src="${app.path}"
          data-app-id="${app.id}"
          title="${app.name}"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
          loading="eager"
        ></iframe>
      </div>
    </div>`;
}

function wireLabApp(appId) {
  const iframe = document.getElementById('lab-app-frame');
  if (!iframe) return;

  const Auth = window.McgheeLab?.Auth;
  const user = Auth?.currentUser;
  const profile = Auth?.currentProfile;

  // Listen for the iframe app to signal it's ready, then send auth
  window.addEventListener('message', function onMsg(e) {
    if (e.origin !== window.location.origin) return;
    if (e.data?.type !== 'mcgheelab-app-ready') return;

    // Send auth data to the embedded app
    iframe.contentWindow.postMessage({
      type: 'mcgheelab-auth',
      token: null,  // Custom token would require Cloud Functions; pass profile directly
      user: user ? { uid: user.uid, email: user.email, displayName: user.displayName } : null,
      profile: profile ? { role: profile.role, name: profile.name, category: profile.category } : null
    }, window.location.origin);

    window.removeEventListener('message', onMsg);
  });

  // Auto-resize iframe to fit content
  window.addEventListener('message', function onResize(e) {
    if (e.origin !== window.location.origin) return;
    if (e.data?.type === 'mcgheelab-app-resize' && e.data.height) {
      iframe.style.height = e.data.height + 'px';
    }
  });
}

/* ─── Exports ───────────────────────────────────────────────── */
McgheeLab.renderLabApps = renderLabApps;
McgheeLab.wireLabApps   = wireLabApps;
McgheeLab.renderLabApp  = renderLabApp;
McgheeLab.wireLabApp    = wireLabApp;
McgheeLab.LAB_APPS      = LAB_APPS;
