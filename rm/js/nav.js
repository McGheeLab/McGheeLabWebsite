/* nav.js — renders shared top navigation with dropdown groups.
 *
 * Per-item access gating: each nav item may carry a `gate` field:
 *   - 'admin'      → only visible when firebridge.isAdmin() is true
 *   - 'lab-member' → only visible when firebridge.isLabMember() is true
 *                    (any non-guest signed-in user)
 *   - undefined    → always visible
 *
 * Items without a gate render for everyone, including signed-out users.
 * Guests are covered by the global pending-access overlay (in firebase-bridge.js)
 * so nav-level hiding for them is secondary; the gate machinery exists mainly
 * to keep grad students / undergrads from seeing PI-only links like Email
 * Triage and the lab-shared Calendar.
 *
 * Gating is applied AFTER initial render — nav appears immediately so the
 * page never flashes empty. firebridge.onAuth then hides gated entries; if
 * every child of a group ends up hidden, the group itself is hidden.
 */

/* Six-group layout introduced in V3.40 to absorb the migrated lab apps and
 * public-site admin into RM. Operations links route through Phase-A iframe
 * bridges (rm/pages/app-<name>.html) until each app is ported to a native
 * RM page in Phase B (V3.41+); the iframe wrapper is replaced with a
 * <meta refresh> redirect at port time so bookmarks survive. */
const NAV_ITEMS = [
  { label: 'Dashboard', href: '/rm/index.html' },

  { label: 'Activity', href: '/rm/pages/activity-overview.html', children: [
    { label: 'Overview', href: '/rm/pages/activity-overview.html' },
    { label: 'Tracker',  href: '/rm/pages/activity-overview.html?tab=tracker' },
    { label: 'Email',    href: '/rm/pages/activity-overview.html?tab=email' },
    { label: 'Year',     href: '/rm/pages/activity-overview.html?tab=timeline' },
    { label: 'Calendar', href: '/rm/pages/calendar.html' },
    { label: 'Tasks',    href: '/rm/pages/tasks.html' },
    { label: 'Sharing',  href: '/rm/pages/sharing.html' },
  ]},

  { label: 'Research', href: '/rm/pages/projects.html', children: [
    { label: 'Projects', href: '/rm/pages/projects.html' },
    { label: 'Library',  href: '/rm/pages/library.html' },
    { label: 'Comments', href: '/rm/pages/library.html?tab=comments' },
    { label: 'Papers',   href: '/rm/pages/paper-builder.html' },
    { label: 'Teaching', href: '/rm/pages/teaching.html' },
    { label: 'Service',  href: '/rm/pages/service.html' },
  ]},

  { label: 'Operations', gate: 'lab-member', children: [
    { label: 'Chat',      href: '/rm/pages/chat.html' },
    { label: 'Huddle',    href: '/rm/pages/huddle.html' },
    { label: 'Meetings',  href: '/rm/pages/meetings.html' },
    { label: 'Scheduler', href: '/rm/pages/scheduler.html' },
    { label: 'Equipment', href: '/rm/pages/equipment.html' },
  ]},

  { label: 'Lab Admin', gate: 'lab-member', children: [
    { label: 'Compliance',        href: '/rm/pages/compliance.html' },
    { label: 'Chemical Safety',   href: '/rm/pages/chemicals.html' },
    { label: 'Inventory',         href: '/rm/pages/inventory.html' },
    { label: 'Lab Members',       href: '/rm/pages/people.html' },
    { label: 'Important People',  href: '/rm/pages/people.html?tab=important' },
    { label: 'Career & Tenure',   href: '/rm/pages/career.html' },
    { label: 'Procurement',       href: '/rm/pages/procurement.html' },
    { label: 'Receipts & Budget', href: '/rm/pages/receipts.html' },
    { label: 'Grant Accounts',    href: '/rm/pages/projects-grants.html' },
    { label: 'Budget',            href: '/rm/pages/budget.html' },
    { label: 'Analytics',         href: '/rm/pages/analytics.html' },
    { label: 'Travel',            href: '/rm/pages/finance.html' },
  ]},

  { label: 'Settings', gate: 'lab-member', children: [
    { label: 'Profile',         href: '/rm/pages/profile.html' },
    { label: 'Settings',        href: '/rm/pages/settings.html' },
    { label: 'CV Editor',       href: '/rm/pages/cv-editor.html' },
    { label: 'CV Overview',     href: '/rm/pages/cv-editor.html?tab=lab' },
    { label: 'Member Activity', href: '/rm/pages/activity-overview.html?tab=lab-stats', gate: 'admin' },
    { label: 'Permissions',     href: '/rm/pages/admin-permissions.html', gate: 'admin' },
  ]},

  // V3.56 — Split View opens a side-by-side shell with two RM pages
  // in iframes. Adapted from the lab-apps.js _splitAppId/_splitRatio
  // harness that the user explicitly flagged as a wanted feature.
  // Top-level entry (no children) so it sits visually distinct from
  // the regular section dropdowns.
  { label: '⊟ Split', href: '/rm/pages/split-view.html' },
];

/* ── V3.64 — Workflow strip ──
 *
 * When a workflow is active in sessionStorage, nav.js renders a focused
 * strip (workflow icon + name + page chips + Leave button) instead of
 * the six-group NAV_ITEMS dropdown bar. The strip's read logic is kept
 * inline here so every page that loads nav.js gets the strip without
 * needing to load page-registry.js / workflow-state.js.
 *
 * Mutations (setActive, addPage, removePage, save-as-custom) are NOT in
 * scope here — those happen on the chooser page (rm/index.html, V3.64)
 * and the custom-workflow builder (V3.65), both of which load the full
 * helpers. */

const _WF_STORAGE_KEY = 'mcgheelab.activeWorkflow';
let _wfDefaultsCache = null;

function _wfReadState() {
  try {
    const raw = sessionStorage.getItem(_WF_STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.id) return null;
    s.kind = s.kind || 'default';
    s.addedPageIds = Array.isArray(s.addedPageIds) ? s.addedPageIds : [];
    s.removedPageIds = Array.isArray(s.removedPageIds) ? s.removedPageIds : [];
    return s;
  } catch (e) { return null; }
}

function _wfClearState() { sessionStorage.removeItem(_WF_STORAGE_KEY); }

/* Adopt `?workflow=<id>` from the URL into sessionStorage. Strip the
 * param from the URL via history.replaceState so the address bar stays
 * clean while the workflow context persists across navigations. */
function _wfAdoptFromUrl() {
  const qp = new URLSearchParams(location.search);
  const wfId = qp.get('workflow');
  if (!wfId) return _wfReadState();
  const existing = _wfReadState();
  let state;
  if (existing && existing.id === wfId) {
    state = existing;  // preserve dirty edits across navigations
  } else {
    state = { id: wfId, kind: 'default', addedPageIds: [], removedPageIds: [] };
  }
  sessionStorage.setItem(_WF_STORAGE_KEY, JSON.stringify(state));
  qp.delete('workflow');
  const qs = qp.toString();
  const newUrl = location.pathname + (qs ? '?' + qs : '') + location.hash;
  try { history.replaceState(history.state, '', newUrl); } catch (e) { /* ignore */ }
  return state;
}

/* Build a flat map of every workflow-pickable page from NAV_ITEMS.
 * Page id is derived from URL+?tab= (matching page-registry.js's logic
 * exactly so ids agree across the codebase). */
function _wfPageIdFromHref(href) {
  if (!href) return '';
  if (href === '/rm/index.html' || href === '/rm/' || href === '/') return 'dashboard';
  const m = href.match(/^\/rm\/pages\/([a-z0-9-]+)\.html(\?(.*))?$/);
  if (!m) return href;
  const slug = m[1];
  const query = m[3] || '';
  if (!query) return slug;
  const qp = new URLSearchParams(query);
  const tab = qp.get('tab');
  if (tab) return slug + '__tab__' + tab;
  return slug + '__q__' + query.replace(/[^a-z0-9_-]/gi, '-');
}

function _wfBuildPageMap() {
  const m = new Map();
  NAV_ITEMS.forEach(item => {
    const groupLabel = item.label;
    if (item.children && item.children.length) {
      if (item.href) {
        const id = _wfPageIdFromHref(item.href);
        if (!m.has(id)) m.set(id, { id, label: item.label, href: item.href, group: groupLabel });
      }
      item.children.forEach(child => {
        const id = _wfPageIdFromHref(child.href);
        if (!m.has(id)) m.set(id, { id, label: child.label, href: child.href, group: groupLabel });
      });
    } else if (item.href) {
      const id = _wfPageIdFromHref(item.href);
      if (!m.has(id)) m.set(id, { id, label: item.label, href: item.href, group: groupLabel });
    }
  });
  return m;
}

/* Fetch the active workflow's record (label + ordered pageIds). Tries
 * Firestore (labConfig/defaultWorkflows or userData/{uid}/customWorkflows
 * for the custom kind); falls back to undefined if not reachable. */
async function _wfFetchWorkflow(state) {
  if (typeof firebridge === 'undefined' || !firebridge.db) return null;
  if (state.kind === 'default') {
    if (!_wfDefaultsCache) {
      try {
        const snap = await firebridge.db().collection('labConfig').doc('defaultWorkflows').get();
        if (snap.exists) {
          const data = snap.data() || {};
          _wfDefaultsCache = Array.isArray(data.workflows) ? data.workflows : [];
        } else {
          _wfDefaultsCache = [];
        }
      } catch (e) {
        _wfDefaultsCache = [];
      }
    }
    return _wfDefaultsCache.find(w => w.id === state.id) || null;
  }
  if (state.kind === 'custom') {
    const u = firebridge.getUser && firebridge.getUser();
    if (!u) return null;
    try {
      const doc = await firebridge.db()
        .collection('userData').doc(u.uid)
        .collection('customWorkflows').doc(state.id).get();
      if (doc.exists) return Object.assign({ id: doc.id }, doc.data() || {});
    } catch (e) { /* ignore */ }
    return null;
  }
  return null;
}

function _wfEffectivePageIds(basePageIds, state) {
  const removed = new Set(state.removedPageIds || []);
  const seen = new Set();
  const out = [];
  (basePageIds || []).concat(state.addedPageIds || []).forEach(id => {
    if (removed.has(id)) return;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  });
  return out;
}

function _wfDecorateHref(href, wfId) {
  if (!href || !wfId) return href;
  const idx = href.indexOf('#');
  const hash = idx >= 0 ? href.slice(idx) : '';
  const path = idx >= 0 ? href.slice(0, idx) : href;
  const qIdx = path.indexOf('?');
  const qs = qIdx >= 0 ? path.slice(qIdx + 1) : '';
  const basePath = qIdx >= 0 ? path.slice(0, qIdx) : path;
  const qp = new URLSearchParams(qs);
  qp.set('workflow', wfId);
  return basePath + '?' + qp.toString() + hash;
}

async function renderWorkflowStrip(state) {
  // Inject workflow.css if the page didn't already include it. Idempotent —
  // browser deduplicates by href.
  if (!document.querySelector('link[href="/rm/css/workflow.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/rm/css/workflow.css';
    document.head.appendChild(link);
  }

  const strip = document.createElement('nav');
  strip.className = 'workflow-strip';

  // Brand link → chooser
  const brand = document.createElement('a');
  brand.className = 'ws-brand';
  brand.href = '/rm/index.html';
  brand.title = 'Switch workflow';
  brand.innerHTML = '<span class="ws-icon">🗂</span><span class="ws-brand-label">Loading…</span>';
  strip.appendChild(brand);

  const pagesEl = document.createElement('div');
  pagesEl.className = 'ws-pages';
  strip.appendChild(pagesEl);

  const actionsEl = document.createElement('div');
  actionsEl.className = 'ws-actions';
  strip.appendChild(actionsEl);

  // Split + Leave buttons render immediately; page chips wait for fetch.
  const splitLink = document.createElement('a');
  splitLink.className = 'ws-btn';
  splitLink.href = _wfDecorateHref('/rm/pages/split-view.html', state.id);
  splitLink.textContent = '⊟ Split';
  splitLink.title = 'Open the split-view shell with the workflow context preserved';
  actionsEl.appendChild(splitLink);

  const leaveBtn = document.createElement('button');
  leaveBtn.className = 'ws-btn';
  leaveBtn.type = 'button';
  leaveBtn.textContent = '× Leave workflow';
  leaveBtn.addEventListener('click', () => {
    _wfClearState();
    location.reload();
  });
  actionsEl.appendChild(leaveBtn);

  document.body.prepend(strip);

  // Wait for auth + access-grant to resolve so canAccessPage filters
  // correctly. firebridge may still be initializing on first paint;
  // both helpers are safe to call before sign-in (they no-op).
  if (typeof firebridge !== 'undefined') {
    if (firebridge.whenAuthResolved) {
      try { await firebridge.whenAuthResolved(); } catch (e) { /* ignore */ }
    }
    if (firebridge.loadAccessGrant) {
      try { await firebridge.loadAccessGrant(); } catch (e) { /* ignore */ }
    }
  }

  // Fetch the workflow record async; populate label + chips.
  const wf = await _wfFetchWorkflow(state);
  if (!wf) {
    brand.querySelector('.ws-brand-label').textContent = 'Workflow not found';
    pagesEl.innerHTML = '<span class="ws-page" style="opacity:.5">No pages</span>';
    return;
  }
  brand.innerHTML = '<span class="ws-icon">' + (wf.icon || '🗂') + '</span>'
                  + '<span class="ws-brand-label">' + (wf.label || wf.id) + '</span>';

  const pageMap = _wfBuildPageMap();
  const ids = _wfEffectivePageIds(wf.pageIds || [], state);
  const isAdmin = (typeof firebridge !== 'undefined') && firebridge.isAdmin && firebridge.isAdmin();
  const canAccess = (id) => {
    if (isAdmin) return true;
    if (typeof firebridge !== 'undefined' && firebridge.canAccessPage) {
      return firebridge.canAccessPage(id);
    }
    return true;
  };
  const currentPath = location.pathname;
  const currentSearch = location.search;
  let renderedAny = false;
  ids.forEach(id => {
    const p = pageMap.get(id);
    if (!p) return;       // page no longer exists — silently skip per locked decision #6
    if (!canAccess(id)) return;
    renderedAny = true;
    const a = document.createElement('a');
    a.className = 'ws-page';
    a.href = _wfDecorateHref(p.href, state.id);
    a.textContent = p.label;
    a.title = p.group + ' · ' + p.label;
    // Active highlight when the path+query matches.
    const target = new URL(p.href, location.origin);
    if (target.pathname === currentPath
        && (target.search === currentSearch || target.search === '')) {
      a.classList.add('active');
    }
    pagesEl.appendChild(a);
  });
  if (!renderedAny) {
    pagesEl.innerHTML = '<span class="ws-page" style="opacity:.5">No accessible pages in this workflow</span>';
  }

  // V3.65 placeholders — Add page + Save as custom buttons. Disabled
  // with a tooltip until PR 3 wires them up. We render them now so the
  // strip's right-hand cluster has its final shape.
  const addBtn = document.createElement('button');
  addBtn.className = 'ws-btn';
  addBtn.type = 'button';
  addBtn.textContent = '+ Add page';
  addBtn.title = 'Add a page to this workflow (coming in V3.65)';
  addBtn.disabled = true;
  addBtn.style.opacity = '.55';
  addBtn.style.cursor = 'not-allowed';
  actionsEl.insertBefore(addBtn, splitLink);

  if (state.kind === 'default'
      && (state.addedPageIds.length || state.removedPageIds.length)) {
    const saveBtn = document.createElement('button');
    saveBtn.className = 'ws-btn ws-btn-primary';
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save as custom';
    saveBtn.title = 'Save this modified workflow under your account (coming in V3.65)';
    saveBtn.disabled = true;
    saveBtn.style.opacity = '.7';
    saveBtn.style.cursor = 'not-allowed';
    actionsEl.insertBefore(saveBtn, splitLink);
  }
}

function renderNav() {
  // V3.64 — adopt ?workflow=<id> from URL into sessionStorage, then
  // pick which nav to render. If a workflow is active, the strip
  // replaces the six-group nav.
  const wfState = _wfAdoptFromUrl();
  if (wfState) {
    renderWorkflowStrip(wfState);
    return;
  }

  const nav = document.createElement('nav');
  nav.className = 'top-nav';

  const brand = document.createElement('a');
  brand.className = 'brand';
  brand.href = '/rm/index.html';
  brand.textContent = 'McGhee Lab';
  nav.appendChild(brand);

  const currentPath = window.location.pathname;
  const isActive = (href) =>
    currentPath === href || (currentPath === '/' && href === '/rm/index.html');

  NAV_ITEMS.forEach(item => {
    if (item.href && !item.children) {
      // Pure direct link (Dashboard).
      const a = document.createElement('a');
      a.href = item.href;
      a.textContent = item.label;
      if (item.gate) a.dataset.gate = item.gate;
      if (isActive(item.href)) a.classList.add('active');
      nav.appendChild(a);
      return;
    }

    // Dropdown group — may also carry its own href, in which case clicking
    // the trigger navigates to the group's landing page (e.g. Activity →
    // Overview) while hovering still reveals the sub-menu.
    const wrapper = document.createElement('div');
    wrapper.className = 'nav-dropdown';
    if (item.gate) wrapper.dataset.gate = item.gate;

    const trigger = item.href
      ? document.createElement('a')
      : document.createElement('button');
    trigger.className = 'nav-dropdown-trigger';
    trigger.textContent = item.label;
    if (item.href) trigger.href = item.href;

    const menu = document.createElement('div');
    menu.className = 'dropdown-menu';

    let groupActive = false;
    item.children.forEach(child => {
      const a = document.createElement('a');
      a.href = child.href;
      a.textContent = child.label;
      if (child.gate) a.dataset.gate = child.gate;
      if (isActive(child.href)) {
        a.classList.add('active');
        groupActive = true;
      }
      menu.appendChild(a);
    });

    if (groupActive || (item.href && isActive(item.href))) {
      trigger.classList.add('active');
    }

    if (item.href) {
      // Navigating item: default anchor behavior handles the click. Hover
      // opens the dropdown so users can still branch to sibling pages.
      wrapper.addEventListener('mouseenter', () => {
        document.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));
        wrapper.classList.add('open');
      });
      wrapper.addEventListener('mouseleave', () => {
        wrapper.classList.remove('open');
      });
    } else {
      // Non-navigating group: click toggles the dropdown.
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = wrapper.classList.contains('open');
        document.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));
        if (!wasOpen) wrapper.classList.add('open');
      });
    }

    wrapper.appendChild(trigger);
    wrapper.appendChild(menu);
    nav.appendChild(wrapper);
  });

  // Close dropdowns when clicking outside
  document.addEventListener('click', () => {
    document.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));
  });

  document.body.prepend(nav);
  // Apply current auth state immediately (likely a no-op if firebridge hasn't
  // fired yet — onAuth will re-call it).
  applyNavGates();
}

/* Show/hide nav entries based on the signed-in user's permissions. Called
 * once at render and again from firebridge.onAuth whenever auth state
 * changes (sign in, sign out, role promotion via live profile snapshot). */
function applyNavGates() {
  const isAdmin     = (typeof firebridge !== 'undefined') && firebridge.isAdmin && firebridge.isAdmin();
  const isLabMember = (typeof firebridge !== 'undefined') && firebridge.isLabMember && firebridge.isLabMember();
  const allowed = (gate) => {
    if (!gate) return true;
    if (gate === 'admin') return !!isAdmin;
    if (gate === 'lab-member') return !!isLabMember;
    return true;
  };

  // Hide individual items whose gate is unmet.
  document.querySelectorAll('.top-nav [data-gate]').forEach(el => {
    el.style.display = allowed(el.dataset.gate) ? '' : 'none';
  });

  // Hide a dropdown group whose visible children are all hidden — keeps the
  // nav from showing an empty "Activity ▾" with no entries inside.
  document.querySelectorAll('.top-nav .nav-dropdown').forEach(group => {
    if (group.dataset.gate && !allowed(group.dataset.gate)) {
      group.style.display = 'none';
      return;
    }
    const links = group.querySelectorAll('.dropdown-menu > a');
    if (!links.length) return;
    let anyVisible = false;
    links.forEach(a => {
      if (a.style.display !== 'none') anyVisible = true;
    });
    if (!anyVisible) group.style.display = 'none';
    else if (!group.dataset.gate || allowed(group.dataset.gate)) group.style.display = '';
  });
}

document.addEventListener('DOMContentLoaded', renderNav);

// Re-apply gates whenever firebridge auth state changes. firebridge.onAuth
// is registered via window.addEventListener so we don't depend on script load
// order — it'll exist by the time the listener runs.
window.addEventListener('DOMContentLoaded', () => {
  if (typeof firebridge !== 'undefined' && firebridge.onAuth) {
    firebridge.onAuth(() => applyNavGates());
  }
});
